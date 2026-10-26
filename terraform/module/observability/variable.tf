variable "name" {
  description = "Prefix for the S3 buckets and IAM roles"
  type        = string
}

variable "namespace" {
  type    = string
  default = "observability"
}

variable "cluster_name" {
  type = string
}

variable "storage_class_name" {
  type = string
}

variable "retention_days" {
  description = "Days of logs (Loki) and traces (Tempo) kept"
  type        = number
  default     = 7
}

variable "prometheus_url" {
  description = "Prometheus base URL; the gateway and Tempo's metrics generator remote-write to it"
  type        = string
}

variable "loki_chart_version" {
  type    = string
  default = "7.3.0"
}

variable "tempo_chart_version" {
  type    = string
  default = "1.24.4"
}

variable "otel_chart_version" {
  type    = string
  default = "0.176.0"
}
