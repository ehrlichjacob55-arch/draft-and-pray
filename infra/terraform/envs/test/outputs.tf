output "cloudfront_domain" {
  value = module.app.cloudfront_domain
}

output "web_bucket" {
  value = module.app.web_bucket
}

output "distribution_id" {
  value = module.app.distribution_id
}

output "ws_url" {
  value = module.app.ws_url
}

output "user_pool_id" {
  value = module.app.user_pool_id
}

output "client_id" {
  value = module.app.client_id
}

output "app_table_name" {
  value = module.app.app_table_name
}

output "stats_api_key_param" {
  value = module.app.stats_api_key_param
}
