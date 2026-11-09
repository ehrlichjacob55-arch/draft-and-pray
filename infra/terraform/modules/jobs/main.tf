terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "name_prefix" {
  type = string
}

variable "app_env" {
  type = string
}

variable "dist_dir" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "app_table_name" {
  type = string
}

variable "app_table_arn" {
  type = string
}

variable "app_table_index_arn" {
  description = "Index ARN pattern (<table arn>/index/*)."
  type        = string
}

variable "ws_table_name" {
  type = string
}

variable "ws_table_arn" {
  type = string
}

variable "ws_management_endpoint" {
  type = string
}

variable "ws_api_execution_arn" {
  type = string
}

variable "ingest_enabled" {
  type    = bool
  default = false
}

variable "draft_backstop_enabled" {
  type    = bool
  default = false
}

locals {
  stats_param_name = "/dnp/${var.app_env}/stats-api-key"

  app_env = {
    APP_ENV   = var.app_env
    APP_TABLE = var.app_table_name
  }

  ws_env = {
    WS_CONNECTIONS_TABLE   = var.ws_table_name
    WS_MANAGEMENT_ENDPOINT = var.ws_management_endpoint
  }
}

# ---- IAM policy documents (least privilege) ----

# App table. No Scan, no DescribeTable, no table admin. TransactWriteItems and
# TransactGetItems are authorized by the underlying item actions below.
data "aws_iam_policy_document" "app_table" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [var.app_table_arn, var.app_table_index_arn]
  }
}

data "aws_iam_policy_document" "ws" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem",
    ]
    resources = [var.ws_table_arn]
  }

  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["${var.ws_api_execution_arn}/*"]
  }
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

data "aws_iam_policy_document" "ingest" {
  source_policy_documents = [
    data.aws_iam_policy_document.app_table.json,
    data.aws_iam_policy_document.ws.json,
  ]

  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.stats_api_key.arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

data "aws_iam_policy_document" "tick" {
  source_policy_documents = [
    data.aws_iam_policy_document.app_table.json,
    data.aws_iam_policy_document.ws.json,
  ]
}

# ---- Functions ----

module "ingest" {
  source = "../lambda_function"

  function_name      = "${var.name_prefix}-job-ingest"
  handler_dir        = "job-ingest"
  dist_dir           = var.dist_dir
  policy_json        = data.aws_iam_policy_document.ingest.json
  timeout            = 120
  memory_size        = 512
  log_retention_days = var.log_retention_days

  environment = merge(local.app_env, local.ws_env, {
    STATS_API_KEY_PARAM = aws_ssm_parameter.stats_api_key.name
  })
}

module "tick" {
  source = "../lambda_function"

  function_name      = "${var.name_prefix}-job-draft-tick"
  handler_dir        = "job-draft-tick"
  dist_dir           = var.dist_dir
  policy_json        = data.aws_iam_policy_document.tick.json
  timeout            = 30
  log_retention_days = var.log_retention_days

  environment = merge(local.app_env, local.ws_env)
}

# ---- SSM: stats API key (value set out of band) ----

resource "aws_ssm_parameter" "stats_api_key" {
  name        = local.stats_param_name
  description = "Sports data API key for job-ingest. Set with aws ssm put-parameter --overwrite."
  type        = "SecureString"
  value       = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- EventBridge Scheduler ----

resource "aws_scheduler_schedule_group" "draft_clock" {
  name = "${var.name_prefix}-draft-clock"
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_invoke" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [module.ingest.function_arn, module.tick.function_arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name   = "invoke-job-functions"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_invoke.json
}

resource "aws_scheduler_schedule" "ingest" {
  name                = "${var.name_prefix}-ingest"
  schedule_expression = "rate(2 minutes)"
  state               = var.ingest_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.ingest.function_arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "schedule" })
  }
}

resource "aws_scheduler_schedule" "draft_tick_backstop" {
  name                = "${var.name_prefix}-draft-tick-backstop"
  schedule_expression = "rate(1 minute)"
  state               = var.draft_backstop_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.tick.function_arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "backstop" })
  }
}

output "draft_tick_function_arn" {
  value = module.tick.function_arn
}

output "scheduler_group_name" {
  value = aws_scheduler_schedule_group.draft_clock.name
}

output "scheduler_group_arn" {
  value = aws_scheduler_schedule_group.draft_clock.arn
}

output "scheduler_role_arn" {
  value = aws_iam_role.scheduler.arn
}

output "stats_api_key_param" {
  value = aws_ssm_parameter.stats_api_key.name
}
