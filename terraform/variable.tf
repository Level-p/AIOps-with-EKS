variable "region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-2"
}

variable "domain_name" {
  description = "The primary domain name for the Route 53 hosted zone"
  type        = string
  default     = "mfon21.space"
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version (check: aws eks describe-cluster-versions --region eu-west-2)"
  type        = string
  default     = "1.35"
}

variable "node_instance_types" {
  description = "Prometheus, Loki, Tempo, the OTel collectors, Kyverno and 5 database pods need memory: t3.large or bigger"
  type        = list(string)
  default     = ["t3.large"]
}

variable "admin_principal_arns" {
  description = <<-EOT
    Extra IAM user/role ARNs that get cluster-admin on EKS.
    The GitHub Actions role from the bootstrap stack is added automatically. Add YOUR IAM ARN to use kubectl
    from your laptop, e.g. ["arn:aws:iam::123456789012:user/steven"].
  EOT
  type        = list(string)
  default     = ["arn:aws:iam::127214197057:user/levelp"]
}

variable "environments" {
  description = "CareSignal environments: one namespace caresignal-<name> each, and how many days its nightly database backups are kept"
  type = map(object({
    backup_retention_days = number
  }))
  default = {
    stage = { backup_retention_days = 7 }
    prod  = { backup_retention_days = 30 }
  }
}

variable "expose_prometheus" {
  description = "Publish Prometheus on https://prometheus.<domain> (it has no login, so keep false and use kubectl port-forward)"
  type        = bool
  default     = false
}

variable "telemetry_retention_days" {
  description = "Days of logs (Loki) and traces (Tempo) kept in S3"
  type        = number
  default     = 7
}

variable "anthropic_api_key" {
  description = "Claude API key for aiops-engine's AI-assisted triage (GitHub secret ANTHROPIC_API_KEY -> TF_VAR_anthropic_api_key). Empty = rule-based triage only"
  type        = string
  default     = ""
  sensitive   = true
}

variable "assistant_anthropic_api_key" {
  description = "Claude API key for the clinical assistant (GitHub secret ASSISTANT_ANTHROPIC_API_KEY). Empty = use anthropic_api_key; both empty = rule-based assistant only. Use a key from a workspace with HIPAA-ready / zero-data-retention terms before any real patient data"
  type        = string
  default     = ""
  sensitive   = true
}

variable "alert_slack_webhook_url" {
  description = "Slack incoming webhook where Alertmanager posts alerts (the workflow passes the ALERT_SLACK_WEBHOOK_URL secret as TF_VAR_alert_slack_webhook_url). Empty = alerts are only shown in Grafana"
  type        = string
  default     = ""
  sensitive   = true
}

variable "git_repo_url" {
  description = "HTTPS URL of THIS repository (Argo CD reads deploy/helm/caresignal from it)"
  type        = string
  default     = "https://github.com/Level-p/AIOps-with-EKS.git"
}

variable "git_revision" {
  description = "Branch Argo CD watches"
  type        = string
  default     = "main"
}

variable "git_repo_token" {
  description = "Read-only GitHub token if the repository is private (the workflow passes the GIT_REPO_TOKEN secret as TF_VAR_git_repo_token)"
  type        = string
  default     = ""
  sensitive   = true
}
