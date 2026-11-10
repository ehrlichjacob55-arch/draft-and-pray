# Whole application stack for one environment. envs/dev and envs/prod call this.
#
# Dependency graph (acyclic):
#   data                                 (no dependencies)
#   realtime <- data                     (ws Lambdas read/consume items in the app table; data never
#                                         references realtime)
#   custom_message <- web                (SITE_URL = CloudFront domain; web's distribution needs only
#                                         the API gateway, never auth)
#   auth  <- custom_message              (pool's CustomMessage trigger; the Lambda permission for the
#                                         pool lives here in the app module)
#   jobs  <- data, realtime              (tick/ingest + scheduler role)
#   api   <- data, auth, realtime, jobs  (http env needs scheduler role + tick ARN + the WebSocket
#                                         stage URL; realtime does not depend on api)
#   web   <- api, auth, realtime         (CloudFront origin + config.json)

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

variable "env" {
  type = string
}

variable "is_prod" {
  type = bool
}

variable "lambda_dist_dir" {
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

variable "ses_identity_arn" {
  type    = string
  default = null
}

variable "ses_from_email" {
  type    = string
  default = null
}

data "aws_region" "current" {}

locals {
  name_prefix        = "dnp-${var.env}"
  log_retention_days = var.is_prod ? 90 : 14
}

module "data" {
  source = "../data"

  name_prefix = local.name_prefix
  is_prod     = var.is_prod
}

# docs/design/13 section 3: rewrites the manager invitation email. Logging-only IAM (no policy_json).
# Cycle-free: pool -> this function -> web.domain_name (the CloudFront distribution), and the
# distribution depends on the API Gateway API only. web's config.json object (not the
# distribution) is what depends on the pool.
module "custom_message" {
  source = "../lambda_function"

  function_name      = "${local.name_prefix}-cognito-custom-message"
  handler_dir        = "cognito-custom-message"
  dist_dir           = var.lambda_dist_dir
  memory_size        = 128
  timeout            = 5
  log_retention_days = local.log_retention_days
  description        = "Cognito CustomMessage trigger: manager invitation email"

  environment = {
    APP_ENV  = var.env
    SITE_URL = "https://${module.web.domain_name}"
  }
}

resource "aws_lambda_permission" "cognito_custom_message" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.custom_message.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = module.auth.user_pool_arn
}

module "auth" {
  source = "../auth"

  name_prefix               = local.name_prefix
  custom_message_lambda_arn = module.custom_message.function_arn
  is_prod                   = var.is_prod
  ses_identity_arn          = var.ses_identity_arn
  ses_from_email            = var.ses_from_email
}

module "realtime" {
  source = "../realtime"

  name_prefix        = local.name_prefix
  app_env            = var.env
  is_prod            = var.is_prod
  dist_dir           = var.lambda_dist_dir
  log_retention_days = local.log_retention_days

  # ws-connect/ws-default read and consume items in the app table (tickets, membership).
  app_table_name      = module.data.table_name
  app_table_arn       = module.data.table_arn
  app_table_index_arn = module.data.index_arn_pattern
}

module "jobs" {
  source = "../jobs"

  name_prefix            = local.name_prefix
  app_env                = var.env
  dist_dir               = var.lambda_dist_dir
  log_retention_days     = local.log_retention_days
  app_table_name         = module.data.table_name
  app_table_arn          = module.data.table_arn
  app_table_index_arn    = module.data.index_arn_pattern
  ws_table_name          = module.realtime.table_name
  ws_table_arn           = module.realtime.table_arn
  ws_management_endpoint = module.realtime.management_endpoint
  ws_api_execution_arn   = module.realtime.api_execution_arn
  ingest_enabled         = var.ingest_enabled
  draft_backstop_enabled = var.draft_backstop_enabled
}

module "api" {
  source = "../api"

  name_prefix             = local.name_prefix
  app_env                 = var.env
  dist_dir                = var.lambda_dist_dir
  log_retention_days      = local.log_retention_days
  app_table_name          = module.data.table_name
  app_table_arn           = module.data.table_arn
  app_table_index_arn     = module.data.index_arn_pattern
  cognito_user_pool_id    = module.auth.user_pool_id
  cognito_user_pool_arn   = module.auth.user_pool_arn
  cognito_client_id       = module.auth.client_id
  ws_table_name           = module.realtime.table_name
  ws_table_arn            = module.realtime.table_arn
  ws_management_endpoint  = module.realtime.management_endpoint
  ws_api_execution_arn    = module.realtime.api_execution_arn
  ws_public_url           = module.realtime.ws_url
  scheduler_group_name    = module.jobs.scheduler_group_name
  scheduler_group_arn     = module.jobs.scheduler_group_arn
  scheduler_role_arn      = module.jobs.scheduler_role_arn
  draft_tick_function_arn = module.jobs.draft_tick_function_arn
}

module "web" {
  source = "../web"

  name_prefix   = local.name_prefix
  api_domain    = module.api.api_domain
  force_destroy = !var.is_prod

  config = {
    apiBaseUrl        = "/api"
    wsUrl             = module.realtime.ws_url
    cognitoUserPoolId = module.auth.user_pool_id
    cognitoClientId   = module.auth.client_id
    region            = data.aws_region.current.region
    env               = var.env
  }
}

output "cloudfront_domain" {
  value = module.web.domain_name
}

output "web_bucket" {
  value = module.web.bucket_name
}

output "distribution_id" {
  value = module.web.distribution_id
}

output "ws_url" {
  value = module.realtime.ws_url
}

output "user_pool_id" {
  value = module.auth.user_pool_id
}

output "client_id" {
  value = module.auth.client_id
}

output "app_table_name" {
  value = module.data.table_name
}

output "stats_api_key_param" {
  value = module.jobs.stats_api_key_param
}
