# ---------------------------------------------------------------------------
# Kyverno: the policy engine (admission control). Terraform installs the engine;
# the policies themselves live in Git (platform/policies) and Argo CD syncs them,
# so a policy change is reviewed like any other change.
#
# To verify image signatures Kyverno must read signatures and attestations from
# ECR: its admission controller gets a read-only ECR role through EKS Pod Identity.
# ---------------------------------------------------------------------------

locals {
  namespace    = "kyverno"
  admission_sa = "kyverno-admission-controller"
}

resource "aws_iam_role" "ecr_read" {
  name = "${var.name}-kyverno-ecr-read"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ecr_read.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_eks_pod_identity_association" "admission" {
  cluster_name    = var.cluster_name
  namespace       = local.namespace
  service_account = local.admission_sa
  role_arn        = aws_iam_role.ecr_read.arn
}

resource "helm_release" "kyverno" {
  name             = "kyverno"
  repository       = "https://kyverno.github.io/kyverno"
  chart            = "kyverno"
  version          = var.chart_version
  namespace        = local.namespace
  create_namespace = true
  timeout          = 600

  values = [yamlencode({
    admissionController = {
      replicas       = var.admission_replicas
      rbac           = { serviceAccount = { name = local.admission_sa } }
      serviceMonitor = { enabled = true }
      container = {
        resources = {
          requests = { cpu = "100m", memory = "256Mi" }
          limits   = { memory = "512Mi" }
        }
      }
    }
    backgroundController = { serviceMonitor = { enabled = true } }
    reportsController    = { serviceMonitor = { enabled = true } }
    cleanupController    = { serviceMonitor = { enabled = true } }
    # Never let a policy lock the cluster itself out
    config = {
      resourceFiltersExcludeNamespaces = ["kube-system", "kyverno"]
    }
  })]

  depends_on = [aws_eks_pod_identity_association.admission]
}
