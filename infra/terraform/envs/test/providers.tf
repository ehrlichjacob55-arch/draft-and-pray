provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "draft-and-pray"
      Environment = local.env
      ManagedBy   = "terraform"
    }
  }
}
