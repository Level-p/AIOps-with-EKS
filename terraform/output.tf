output "cluster_name" {
  value = module.eks.cluster_name
}

output "configure_kubectl" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region}"
}

output "ecr_repositories" {
  value = module.ecr.repository_urls
}

output "argocd_url" {
  value = module.argocd.argocd_url
}

output "argocd_admin_password_command" {
  value = module.argocd.admin_password_command
}

output "telemetry_buckets" {
  description = "S3 buckets where Loki (logs) and Tempo (traces) keep their data"
  value       = module.observability.buckets
}

output "grafana_url" {
  description = "Metrics, logs (Loki), traces (Tempo) and alerts"
  value       = module.monitoring.grafana_url
}

output "grafana_admin_password_command" {
  description = "Grafana login: user admin"
  value       = module.monitoring.grafana_admin_password_command
}

output "prometheus_url" {
  value = module.monitoring.prometheus_url
}

output "db_backup_bucket" {
  description = "Nightly pg_dump of every database, one folder per environment"
  value       = module.app_namespaces.backup_bucket
}

output "caresignal_urls" {
  value = {
    stage = "https://caresignal-stage.${var.domain_name}"
    prod  = "https://caresignal.${var.domain_name}"
  }
}

output "clinician_token_command" {
  description = "Token for the dashboard / clinician API (demo authentication)"
  value       = "kubectl get secret caresignal-app-secrets -n caresignal-prod -o jsonpath='{.data.clinician-token}' | base64 -d; echo"
}
