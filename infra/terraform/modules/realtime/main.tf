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

variable "is_prod" {
  type    = bool
  default = false
}

variable "dist_dir" {
  type = string
}

variable "app_table_name" {
  description = "App table: ws-connect consumes WSTICKET# items, ws-default checks league membership (docs/design/14 section 6)."
  type        = string
}

variable "app_table_arn" {
  type = string
}

variable "app_table_index_arn" {
  description = "Index ARN pattern (<table arn>/index/*)."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "stage_name" {
  type    = string
  default = "live"
}

data "aws_region" "current" {}

resource "aws_dynamodb_table" "connections" {
  name         = "${var.name_prefix}-ws-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.is_prod
  }
}

resource "aws_apigatewayv2_api" "ws" {
  name                       = "${var.name_prefix}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

data "aws_iam_policy_document" "ws_lambda" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem",
    ]
    resources = [aws_dynamodb_table.connections.arn]
  }

  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.ws.execution_arn}/*"]
  }

  # App table, least privilege: ws-connect deletes (consumes) tickets; ws-default reads season
  # META and the league MEMBER item to authorize a subscription. No writes beyond DeleteItem.
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [var.app_table_arn, var.app_table_index_arn]
  }
}

locals {
  routes = {
    "$connect"    = "ws-connect"
    "$disconnect" = "ws-disconnect"
    "$default"    = "ws-default"
  }
}

module "fn" {
  source   = "../lambda_function"
  for_each = toset(values(local.routes))

  function_name      = "${var.name_prefix}-${each.value}"
  handler_dir        = each.value
  dist_dir           = var.dist_dir
  policy_json        = data.aws_iam_policy_document.ws_lambda.json
  log_retention_days = var.log_retention_days

  environment = {
    APP_ENV              = var.app_env
    WS_CONNECTIONS_TABLE = aws_dynamodb_table.connections.name
    APP_TABLE            = var.app_table_name
  }
}

resource "aws_apigatewayv2_integration" "ws" {
  for_each = local.routes

  api_id             = aws_apigatewayv2_api.ws.id
  integration_type   = "AWS_PROXY"
  integration_uri    = module.fn[each.value].invoke_arn
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "ws" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.ws.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.ws[each.key].id}"
}

resource "aws_lambda_permission" "ws" {
  for_each = local.routes

  statement_id  = "AllowWebSocketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.fn[each.value].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/${each.key}"
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = var.stage_name
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 50
  }

  depends_on = [aws_apigatewayv2_route.ws]
}

output "ws_url" {
  value = "wss://${aws_apigatewayv2_api.ws.id}.execute-api.${data.aws_region.current.region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

output "management_endpoint" {
  value = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${data.aws_region.current.region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

output "table_name" {
  value = aws_dynamodb_table.connections.name
}

output "table_arn" {
  value = aws_dynamodb_table.connections.arn
}

output "api_execution_arn" {
  description = "Use as <arn>/* for execute-api:ManageConnections."
  value       = aws_apigatewayv2_api.ws.execution_arn
}
