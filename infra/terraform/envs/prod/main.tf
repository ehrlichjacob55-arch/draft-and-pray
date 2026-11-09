locals {
  env = "prod"
}

module "app" {
  source = "../../modules/app"

  env                    = local.env
  is_prod                = true
  lambda_dist_dir        = abspath("${path.root}/${var.lambda_dist_dir}")
  ingest_enabled         = var.ingest_enabled
  draft_backstop_enabled = var.draft_backstop_enabled
  ses_identity_arn       = var.ses_identity_arn
  ses_from_email         = var.ses_from_email
}
