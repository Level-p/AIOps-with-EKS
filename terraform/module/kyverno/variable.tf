variable "name" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "chart_version" {
  type    = string
  default = "3.9.1" # Kyverno v1.19.1
}

variable "admission_replicas" {
  description = "Admission controller replicas (3 for high availability; the webhook fails closed for enforced policies)"
  type        = number
  default     = 3
}
