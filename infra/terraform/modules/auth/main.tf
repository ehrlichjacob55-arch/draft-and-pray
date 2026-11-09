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

# Email OTP may require SES as the sender instead of COGNITO_DEFAULT; see
# docs/design/09-aws-architecture.md section 7. Leave null to use Cognito's default sender.
variable "is_prod" {
  description = "The test-users group (docs/design/11 section 3.4) is created only outside prod."
  type        = bool
  default     = true
}

variable "ses_identity_arn" {
  type    = string
  default = null
}

variable "ses_from_email" {
  type    = string
  default = null
}

# CustomMessage trigger Lambda (docs/design/13 section 3). It is created outside this module (it
# needs the CloudFront domain, and the web config needs this pool) and passed in by ARN.
variable "custom_message_lambda_arn" {
  type    = string
  default = null
}

locals {
  use_ses = var.ses_identity_arn != null
}

resource "aws_cognito_user_pool" "this" {
  name                     = "${var.name_prefix}-users"
  user_pool_tier           = "ESSENTIALS"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"

  # Passwordless email OTP. PASSWORD must be listed alongside EMAIL_OTP.
  sign_in_policy {
    allowed_first_auth_factors = ["EMAIL_OTP", "PASSWORD"]
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # Invitation codes (temporary passwords) stay valid for 7 days; the UI and docs say so.
  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  dynamic "lambda_config" {
    for_each = var.custom_message_lambda_arn == null ? [] : [1]

    content {
      custom_message = var.custom_message_lambda_arn
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = local.use_ses ? "DEVELOPER" : "COGNITO_DEFAULT"
    source_arn            = local.use_ses ? var.ses_identity_arn : null
    from_email_address    = local.use_ses ? var.ses_from_email : null
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# Generated test users (scripts/admin test-users). Never exists in prod.
resource "aws_cognito_user_group" "test_users" {
  count = var.is_prod ? 0 : 1

  name         = "test-users"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Generated test users for smoke tests (never in prod)"
}

output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.this.arn
}

output "client_id" {
  value = aws_cognito_user_pool_client.web.id
}
