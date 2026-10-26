# ---------------------------------------------------------------------------
# CareSignal on Amazon EKS: DevSecAIGitOps platform
#
#   network + EKS (VPC CNI network policies on) -> ECR (immutable, scan on push)
#   add-ons (ALB controller, ExternalDNS, metrics-server, gp3)
#   namespaces + secrets (stage, prod, aiops) + backups (S3, Pod Identity)
#   monitoring: Prometheus (remote-write receiver for OTel), Alertmanager -> Slack + aiops-engine,
#               Grafana with Loki and Tempo data sources
#   observability: OpenTelemetry collectors (node agents + gateway), Loki (logs) and Tempo (traces) in S3
#   policy: Kyverno (signed images, registries, hardening; policies come from Git via Argo CD)
#   postgres-operator, Argo CD (apps, policies, aiops-engine; Slack notifications)
# ---------------------------------------------------------------------------

locals {
  name                 = "caresignal"
  cluster_name         = "caresignal-eks"
  tools_alb_group_name = "caresignal-tools" # one ALB shared by Argo CD and Grafana
  observability_ns     = "observability"
  loki_url             = "http://loki.${local.observability_ns}.svc:3100"
  tempo_url            = "http://tempo.${local.observability_ns}.svc:3200"
  aiops_webhook_url    = "http://aiops-engine.aiops.svc:8080/alertmanager"
}

# ---- Lookups (created by the bootstrap stack) ----
data "aws_route53_zone" "zone" {
  name         = var.domain_name
  private_zone = false
}

data "aws_acm_certificate" "cert" {
  domain      = var.domain_name
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_caller_identity" "current" {}

# GitHub Actions runs this Terraform, so its role must be an EKS administrator
data "aws_iam_role" "github_actions" {
  name = "${local.name}-github-actions"
}

# ---- Network ----
module "vpc" {
  source       = "./module/vpc"
  name         = local.name
  cluster_name = local.cluster_name
}

# ---- EKS cluster ----
module "eks" {
  source             = "./module/eks"
  cluster_name       = local.cluster_name
  kubernetes_version = var.kubernetes_version
  instance_types     = var.node_instance_types
  node_desired_size  = 3
  node_max_size      = 6
  private_subnet_ids = [
    module.vpc.private_subnet_ids["pri1"],
    module.vpc.private_subnet_ids["pri2"],
    module.vpc.private_subnet_ids["pri3"]
  ]
  admin_principal_arns = distinct(concat([data.aws_iam_role.github_actions.arn], var.admin_principal_arns))
}

# ---- Container registry: one repository per service ----
module "ecr" {
  source = "./module/ecr"
  repositories = [
    "${local.name}/vitals-ingest",
    "${local.name}/records-api",
    "${local.name}/clinical-assistant",
    "${local.name}/aiops-engine",
  ]
}

# ---- Load balancer controller, DNS, metrics, storage ----
module "eks_addons" {
  source         = "./module/eks-addons"
  cluster_name   = module.eks.cluster_name
  region         = var.region
  vpc_id         = module.vpc.vpc_id
  domain_name    = var.domain_name
  hosted_zone_id = data.aws_route53_zone.zone.zone_id
}

# ---- Stage, prod and aiops namespaces: labels, secrets, database backups ----
module "app_namespaces" {
  source       = "./module/app-namespaces"
  name         = local.name
  cluster_name = module.eks.cluster_name
  environments = var.environments

  slack_webhook_url = var.alert_slack_webhook_url
  anthropic_api_key = var.anthropic_api_key
  # The clinical assistant gets its own key when one is given (separate workspace: own spend
  # limit, usage and rotation); otherwise it shares aiops-engine's key
  assistant_anthropic_api_key = var.assistant_anthropic_api_key != "" ? var.assistant_anthropic_api_key : var.anthropic_api_key

  depends_on = [module.eks_addons]
}

# ---- Metrics and alerting: Prometheus, Alertmanager, Grafana ----
module "monitoring" {
  source             = "./module/monitoring"
  domain_name        = var.domain_name
  certificate_arn    = data.aws_acm_certificate.cert.arn
  alb_group_name     = local.tools_alb_group_name
  storage_class_name = module.eks_addons.storage_class_name
  expose_prometheus  = var.expose_prometheus
  loki_url           = local.loki_url
  tempo_url          = local.tempo_url

  alert_slack_webhook_url = var.alert_slack_webhook_url
  aiops_webhook_url       = local.aiops_webhook_url
  aiops_webhook_token     = module.app_namespaces.aiops_webhook_token

  depends_on = [module.eks_addons]
}

# ---- OpenTelemetry collectors, Loki (logs) and Tempo (traces) ----
module "observability" {
  source             = "./module/observability"
  name               = local.name
  namespace          = local.observability_ns
  cluster_name       = module.eks.cluster_name
  storage_class_name = module.eks_addons.storage_class_name
  retention_days     = var.telemetry_retention_days
  prometheus_url     = "http://kube-prometheus-stack-prometheus.monitoring.svc:9090"

  # ServiceMonitors need the Prometheus Operator CRDs
  depends_on = [module.eks_addons, module.monitoring]
}

# ---- Policy engine: Kyverno (the policies themselves are synced from Git by Argo CD) ----
module "kyverno" {
  source       = "./module/kyverno"
  name         = local.name
  cluster_name = module.eks.cluster_name

  depends_on = [module.eks_addons, module.monitoring]
}

# ---- PostgreSQL operator: self-managed, highly available databases ----
module "postgres_operator" {
  source = "./module/postgres-operator"

  depends_on = [module.eks_addons]
}

# ---- GitOps: Argo CD, the CareSignal apps, aiops-engine and the platform policies ----
module "argocd" {
  source            = "./module/argocd"
  domain_name       = var.domain_name
  certificate_arn   = data.aws_acm_certificate.cert.arn
  alb_group_name    = local.tools_alb_group_name
  git_repo_url      = var.git_repo_url
  git_revision      = var.git_revision
  git_repo_token    = var.git_repo_token
  slack_webhook_url = var.alert_slack_webhook_url

  # Before Argo CD deploys anything, the cluster must understand everything in the
  # charts (postgresql, ServiceMonitor, PrometheusRule, Kyverno ClusterPolicy) and the
  # namespaces must hold their secrets.
  depends_on = [module.eks_addons, module.app_namespaces, module.monitoring, module.postgres_operator,
  module.kyverno, module.observability]
}
