# ---------------------------------------------------------------------------
# OpenTelemetry pipeline (one standard for all telemetry, vendor-neutral):
#
#   apps (OTel SDK) --OTLP--> otel-gateway (Deployment) --traces--> Tempo   (S3)
#                                                        --metrics-> Prometheus (remote write)
#   container stdout --filelog--> otel-agent (DaemonSet) --OTLP--> otel-gateway --logs--> Loki (S3)
#
# The gateway is the policy point: it adds Kubernetes metadata, strips identifiers
# from span attributes (HealthTech: no patient ids in traces), drops noisy resource
# attributes before they become Prometheus labels, and keeps every error and slow
# trace while sampling 10 % of the rest (tail sampling).
# Loki and Tempo keep their data in S3, reached with EKS Pod Identity (no keys).
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  region          = data.aws_region.current.region
  retention_hours = "${var.retention_days * 24}h"
  stores = {
    loki  = { bucket = "${var.name}-loki-${data.aws_caller_identity.current.account_id}", sa = "loki" }
    tempo = { bucket = "${var.name}-tempo-${data.aws_caller_identity.current.account_id}", sa = "tempo" }
  }
  gateway_endpoint = "otel-gateway-opentelemetry-collector.${var.namespace}.svc:4317"

  # A patient id must never be stored in a trace: /api/patients/<uuid> -> /api/patients/{id}
  uuid_pattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name = var.namespace
  }
}

# ---- 1. S3 buckets for logs and traces ----
resource "aws_s3_bucket" "store" {
  for_each      = local.stores
  bucket        = each.value.bucket
  force_destroy = true # telemetry is disposable; terraform destroy empties the bucket
}

resource "aws_s3_bucket_public_access_block" "store" {
  for_each                = local.stores
  bucket                  = aws_s3_bucket.store[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "store" {
  for_each = local.stores
  bucket   = aws_s3_bucket.store[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  for_each = local.stores
  bucket   = aws_s3_bucket.store[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.store[each.key].arn, "${aws_s3_bucket.store[each.key].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.store]
}

# Safety net: Loki's compactor and Tempo's retention delete old data; leftovers go after twice the retention
resource "aws_s3_bucket_lifecycle_configuration" "store" {
  for_each = local.stores
  bucket   = aws_s3_bucket.store[each.key].id
  rule {
    id     = "expire-leftovers"
    status = "Enabled"
    filter {}
    expiration {
      days = var.retention_days * 2
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# ---- 2. AWS access for Loki and Tempo (EKS Pod Identity) ----
resource "aws_iam_role" "store" {
  for_each = local.stores
  name     = "${var.name}-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy" "store" {
  for_each = local.stores
  name     = "${each.key}-bucket"
  role     = aws_iam_role.store[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.store[each.key].arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.store[each.key].arn}/*" },
    ]
  })
}

resource "aws_eks_pod_identity_association" "store" {
  for_each        = local.stores
  cluster_name    = var.cluster_name
  namespace       = kubernetes_namespace_v1.this.metadata[0].name
  service_account = each.value.sa
  role_arn        = aws_iam_role.store[each.key].arn
}

# ---- 3. Loki: logs ----
resource "helm_release" "loki" {
  name       = "loki"
  repository = "https://grafana.github.io/helm-charts"
  chart      = "loki"
  version    = var.loki_chart_version
  namespace  = kubernetes_namespace_v1.this.metadata[0].name
  timeout    = 600

  values = [yamlencode({
    deploymentMode = "SingleBinary"
    loki = {
      auth_enabled = false
      commonConfig = { replication_factor = 1 }
      schemaConfig = {
        configs = [{
          from         = "2026-01-01"
          store        = "tsdb"
          object_store = "s3"
          schema       = "v13"
          index        = { prefix = "loki_index_", period = "24h" }
        }]
      }
      storage = {
        type        = "s3"
        bucketNames = { chunks = local.stores.loki.bucket, ruler = local.stores.loki.bucket, admin = local.stores.loki.bucket }
        s3          = { region = local.region }
      }
      limits_config = {
        retention_period           = local.retention_hours
        reject_old_samples         = true
        reject_old_samples_max_age = "168h"
        max_query_lookback         = local.retention_hours
        allow_structured_metadata  = true # OTLP attributes that are not labels
        volume_enabled             = true
      }
      compactor = {
        retention_enabled    = true
        delete_request_store = "s3"
      }
    }
    serviceAccount = { create = true, name = local.stores.loki.sa }
    singleBinary = {
      replicas = 1
      persistence = {
        enabled      = true
        storageClass = var.storage_class_name
        size         = "10Gi"
      }
      resources = {
        requests = { cpu = "100m", memory = "512Mi" }
        limits   = { memory = "1Gi" }
      }
    }
    backend      = { replicas = 0 }
    read         = { replicas = 0 }
    write        = { replicas = 0 }
    chunksCache  = { enabled = false }
    resultsCache = { enabled = false }
    gateway      = { enabled = false }
    lokiCanary   = { enabled = false }
    test         = { enabled = false }
    minio        = { enabled = false }
    monitoring   = { serviceMonitor = { enabled = true } }
  })]

  depends_on = [aws_eks_pod_identity_association.store, aws_iam_role_policy.store]
}

# ---- 4. Tempo: traces (+ service graph and span metrics into Prometheus) ----
resource "helm_release" "tempo" {
  name       = "tempo"
  repository = "https://grafana.github.io/helm-charts"
  chart      = "tempo"
  version    = var.tempo_chart_version
  namespace  = kubernetes_namespace_v1.this.metadata[0].name
  timeout    = 600

  values = [yamlencode({
    tempo = {
      retention = local.retention_hours
      storage = {
        trace = {
          backend = "s3"
          s3      = { bucket = local.stores.tempo.bucket, endpoint = "s3.${local.region}.amazonaws.com", region = local.region }
          wal     = { path = "/var/tempo/wal" }
        }
      }
      # RED metrics and the service map, computed from the traces, written to Prometheus
      metricsGenerator = {
        enabled        = true
        remoteWriteUrl = "${var.prometheus_url}/api/v1/write"
      }
      resources = {
        requests = { cpu = "100m", memory = "512Mi" }
        limits   = { memory = "1Gi" }
      }
    }
    serviceAccount = { create = true, name = local.stores.tempo.sa }
    persistence    = { enabled = true, storageClassName = var.storage_class_name, size = "10Gi" }
    serviceMonitor = { enabled = true }
  })]

  depends_on = [aws_eks_pod_identity_association.store, aws_iam_role_policy.store]
}

# ---- 5. OpenTelemetry gateway: receives OTLP from the apps, processes, exports ----
resource "helm_release" "otel_gateway" {
  name       = "otel-gateway"
  repository = "https://open-telemetry.github.io/opentelemetry-helm-charts"
  chart      = "opentelemetry-collector"
  version    = var.otel_chart_version
  namespace  = kubernetes_namespace_v1.this.metadata[0].name

  values = [templatefile("${path.module}/values/otel-gateway.yaml.tftpl", {
    namespace      = var.namespace
    prometheus_url = var.prometheus_url
    uuid_pattern   = local.uuid_pattern
    drop_attributes = ["process.pid", "process.command_args", "process.executable.path", "process.runtime.description",
      "service.instance.id", "telemetry.sdk.language", "telemetry.sdk.name", "telemetry.sdk.version",
    "telemetry.auto.version", "k8s.pod.uid", "k8s.pod.start_time", "host.name"]
  })]

  depends_on = [helm_release.loki, helm_release.tempo]
}

# ---- 6. OpenTelemetry agent on every node: container logs -> gateway ----
resource "helm_release" "otel_agent" {
  name       = "otel-agent"
  repository = "https://open-telemetry.github.io/opentelemetry-helm-charts"
  chart      = "opentelemetry-collector"
  version    = var.otel_chart_version
  namespace  = kubernetes_namespace_v1.this.metadata[0].name

  values = [templatefile("${path.module}/values/otel-agent.yaml.tftpl", {
    gateway_endpoint = local.gateway_endpoint
  })]

  depends_on = [helm_release.otel_gateway]
}
