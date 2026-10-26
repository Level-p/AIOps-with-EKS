output "buckets" {
  value = { for k, b in aws_s3_bucket.store : k => b.bucket }
}

output "otlp_endpoint" {
  description = "Where applications send OTLP/gRPC"
  value       = "http://${local.gateway_endpoint}"
}
