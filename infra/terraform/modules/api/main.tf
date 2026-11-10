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

variable "cognito_user_pool_id" {
  type = string
}

variable "cognito_user_pool_arn" {
  description = "Allows the http Lambda to invite, look up and remove manager users (docs/design/11 section 3.3, 13)."
  type        = string
}

variable "cognito_client_id" {
  type = string
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

variable "ws_public_url" {
  description = "WebSocket stage URL (wss://...) returned by POST /realtime/ticket."
  type        = string
}

variable "scheduler_group_name" {
  type = string
}

variable "scheduler_group_arn" {
  type = string
}

variable "scheduler_role_arn" {
  type = string
}

variable "draft_tick_function_arn" {
  type = string
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "http" {
  # App table. No Scan, no DescribeTable, no table admin. TransactWriteItems and
  # TransactGetItems are authorized by the underlying item actions below.
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
    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminDeleteUser",
    ]
    resources = [var.cognito_user_pool_arn]
  }

  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["${var.ws_api_execution_arn}/*"]
  }

  # Per-pick one-time schedules live in the draft-clock group.
  statement {
    actions   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]
    resources = ["arn:${data.aws_partition.current.partition}:scheduler:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:schedule/${var.scheduler_group_name}/*"]
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [var.scheduler_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }
}

module "http" {
  source = "../lambda_function"

  function_name      = "${var.name_prefix}-http"
  handler_dir        = "http"
  dist_dir           = var.dist_dir
  policy_json        = data.aws_iam_policy_document.http.json
  memory_size        = 512
  timeout            = 29
  log_retention_days = var.log_retention_days

  environment = {
    APP_ENV                 = var.app_env
    APP_TABLE               = var.app_table_name
    COGNITO_USER_POOL_ID    = var.cognito_user_pool_id
    COGNITO_CLIENT_ID       = var.cognito_client_id
    WS_CONNECTIONS_TABLE    = var.ws_table_name
    WS_MANAGEMENT_ENDPOINT  = var.ws_management_endpoint
    WS_PUBLIC_URL           = var.ws_public_url
    SCHEDULER_GROUP         = var.scheduler_group_name
    SCHEDULER_ROLE_ARN      = var.scheduler_role_arn
    DRAFT_TICK_FUNCTION_ARN = var.draft_tick_function_arn
  }
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name_prefix}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "http" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.http.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.http.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name_prefix}-http"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      path           = "$context.path"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      latency        = "$context.responseLatency"
      integrationErr = "$context.integrationErrorMessage"
    })
  }

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_lambda_permission" "http" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.http.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "api_domain" {
  description = "Host name of the HTTP API (no scheme), used as the CloudFront origin."
  value       = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
}

output "function_name" {
  value = module.http.function_name
}
