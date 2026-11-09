terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "region" {
  description = "AWS region for the state bucket."
  type        = string
  default     = "us-east-2"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "draft-and-pray"
      ManagedBy = "terraform"
      Purpose   = "tfstate"
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "dnp-tfstate-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

variable "environments" {
  description = "Environments that get a GitHub deploy IAM user."
  type        = set(string)
  default     = ["dev", "test", "prod"]
}

# One IAM user per environment for GitHub Actions (docs/design/09 section 8). The org SCP denies
# iam:CreateOpenIDConnectProvider, so OIDC roles are not possible; static access keys are used.
#
# Deliberately NO aws_iam_access_key resource: Terraform would store the secret key in plaintext
# in state. Keys are created by scripts/setup-github.sh and piped straight into GitHub
# environment secrets.
resource "aws_iam_user" "github_deploy" {
  for_each = var.environments

  name = "dnp-github-deploy-${each.key}"
  path = "/"

  tags = {
    Environment = each.key
  }
}

# v1: AdministratorAccess (Terraform creates IAM, Lambda, Cognito, CloudFront...). Narrowing this
# is a later hardening task; see docs/design/09-aws-architecture.md section 8.
resource "aws_iam_user_policy_attachment" "github_deploy_admin" {
  for_each = var.environments

  user       = aws_iam_user.github_deploy[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "region" {
  value = var.region
}

output "deploy_user_names" {
  description = "Environment name to GitHub deploy IAM user name."
  value       = { for env, user in aws_iam_user.github_deploy : env => user.name }
}
