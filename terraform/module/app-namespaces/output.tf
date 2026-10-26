output "namespaces" {
  value = [for ns in kubernetes_namespace_v1.env : ns.metadata[0].name]
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.bucket
}

output "backup_role_arns" {
  value = { for k, r in aws_iam_role.backup : k => r.arn }
}

output "aiops_webhook_token" {
  description = "Bearer token Alertmanager sends to aiops-engine"
  value       = random_password.aiops_webhook.result
  sensitive   = true
}
