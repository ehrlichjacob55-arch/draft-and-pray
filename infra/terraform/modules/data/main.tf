# Application table (single-table design). Must match packages/db/src/table.ts
# and docs/design/09-aws-architecture.md section 4 "App table definition".

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

variable "is_prod" {
  type = bool
}

resource "aws_dynamodb_table" "app" {
  name         = "${var.name_prefix}-app"
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

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # Encryption at rest: DynamoDB always encrypts; with no server_side_encryption
  # block the AWS owned key is used (no cost, no KMS permissions needed).

  point_in_time_recovery {
    enabled = var.is_prod
  }

  deletion_protection_enabled = var.is_prod
}

output "table_name" {
  value = aws_dynamodb_table.app.name
}

output "table_arn" {
  value = aws_dynamodb_table.app.arn
}

output "index_arn_pattern" {
  value = "${aws_dynamodb_table.app.arn}/index/*"
}
