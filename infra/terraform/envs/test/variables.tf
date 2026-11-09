variable "region" {
  type    = string
  default = "us-east-1"
}

variable "lambda_dist_dir" {
  description = "Directory containing one built sub-directory per Lambda handler."
  type        = string
  default     = "../../../../apps/api/dist"
}

variable "ingest_enabled" {
  description = "Enable the recurring stats ingest schedule."
  type        = bool
  default     = false
}

variable "draft_backstop_enabled" {
  description = "Enable the 1-minute draft clock backstop schedule (draft night only)."
  type        = bool
  default     = false
}

variable "ses_identity_arn" {
  description = "Optional SES identity for Cognito email (see docs/design/09 section 7)."
  type        = string
  default     = null
}

variable "ses_from_email" {
  type    = string
  default = null
}
