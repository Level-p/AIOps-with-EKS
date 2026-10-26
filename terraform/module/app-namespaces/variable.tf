variable "name" {
  description = "Base name, e.g. caresignal"
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "environments" {
  description = "Environment name => settings. One namespace caresignal-<name> per entry."
  type = map(object({
    backup_retention_days = number
  }))
}

variable "force_destroy_backups" {
  description = "Let terraform destroy delete the backup bucket even if it still holds backups (true for labs; set false for real data)"
  type        = bool
  default     = true
}

variable "slack_webhook_url" {
  description = "Slack incoming webhook for aiops-engine's enriched incident messages (empty = log only)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "assistant_anthropic_api_key" {
  description = "Claude API key for clinical-assistant in each environment (empty = rule-based assistant)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Claude API key for AI-assisted triage (empty = rule-based triage)"
  type        = string
  default     = ""
  sensitive   = true
}
