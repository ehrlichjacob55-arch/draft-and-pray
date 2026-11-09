# Committed, non-secret inputs only (docs/design/09 section 8). Secrets live in SSM.
region = "us-east-2"

# Flip on only when needed.
ingest_enabled         = false
draft_backstop_enabled = false

# Optional: SES sender for Cognito email OTP (docs/design/09 section 7).
# ses_identity_arn = "arn:aws:ses:us-east-2:123456789012:identity/you@example.com"
# ses_from_email   = "you@example.com"
