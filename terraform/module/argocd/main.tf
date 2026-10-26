# ---------------------------------------------------------------------------
# Argo CD (GitOps): Git is the only way anything reaches the cluster.
#   helm_release.argocd       -> Argo CD, UI at https://argocd.<domain>, Slack notifications
#   kubernetes_secret_v1.repo -> optional credentials for a private Git repo
#   helm_release.argocd_apps  -> projects and applications:
#       caresignal-stage   auto-sync + self-heal (every merge to main deploys)
#       caresignal-prod    manual sync (a person presses Sync after the promotion PR)
#       aiops-engine       auto-sync (namespace aiops)
#       platform-policies  auto-sync (Kyverno ClusterPolicies from platform/policies)
# ---------------------------------------------------------------------------

locals {
  server_values = yamlencode({
    global = { domain = local.argocd_host }
    configs = {
      params = { "server.insecure" = true } # TLS ends at the ALB
    }
    controller = { metrics = { enabled = true, serviceMonitor = { enabled = var.enable_service_monitors } } }
    repoServer = { metrics = { enabled = true, serviceMonitor = { enabled = var.enable_service_monitors } } }
    server = {
      metrics = { enabled = true, serviceMonitor = { enabled = var.enable_service_monitors } }
      ingress = {
        enabled          = true
        controller       = "generic"
        ingressClassName = "alb"
        hostname         = local.argocd_host
        path             = "/"
        pathType         = "Prefix"
        annotations = {
          "alb.ingress.kubernetes.io/scheme"           = "internet-facing"
          "alb.ingress.kubernetes.io/target-type"      = "ip"
          "alb.ingress.kubernetes.io/group.name"       = var.alb_group_name
          "alb.ingress.kubernetes.io/listen-ports"     = "[{\"HTTP\": 80}, {\"HTTPS\": 443}]"
          "alb.ingress.kubernetes.io/ssl-redirect"     = "443"
          "alb.ingress.kubernetes.io/certificate-arn"  = var.certificate_arn
          "alb.ingress.kubernetes.io/healthcheck-path" = "/healthz"
        }
      }
    }
  })

  argocd_host   = "argocd.${var.domain_name}"
  slack_enabled = nonsensitive(var.slack_webhook_url != "")

  retry = {
    limit   = 5
    backoff = { duration = "10s", factor = 2, maxDuration = "3m" }
  }

  app_env = { for env, auto in { stage = true, prod = false } : "caresignal-${env}" => {
    namespace  = "argocd"
    project    = "caresignal"
    finalizers = ["resources-finalizer.argocd.argoproj.io"]
    ignoreDifferences = [{
      group        = "apps"
      kind         = "Deployment"
      jsonPointers = ["/spec/replicas"] # owned by the HPA
    }]
    source = {
      repoURL        = var.git_repo_url
      targetRevision = var.git_revision
      path           = "deploy/helm/caresignal"
      helm = {
        releaseName = "caresignal"
        valueFiles  = ["values.yaml", "values-${env}.yaml"]
        parameters  = [{ name = "ingress.certificateArn", value = var.certificate_arn }]
      }
    }
    destination = { server = "https://kubernetes.default.svc", namespace = "caresignal-${env}" }
    # Stage syncs itself; prod waits for a person (automated = null = manual sync)
    syncPolicy = {
      automated   = auto ? { prune = true, selfHeal = true } : null
      syncOptions = ["CreateNamespace=false"]
      retry       = local.retry
    }
  } }

  applications = merge(local.app_env, {
    "aiops-engine" = {
      namespace  = "argocd"
      project    = "caresignal"
      finalizers = ["resources-finalizer.argocd.argoproj.io"]
      source = {
        repoURL        = var.git_repo_url
        targetRevision = var.git_revision
        path           = "deploy/helm/aiops-engine"
        helm           = { releaseName = "aiops-engine" }
      }
      destination = { server = "https://kubernetes.default.svc", namespace = "aiops" }
      syncPolicy  = { automated = { prune = true, selfHeal = true }, retry = local.retry }
    }
    "platform-policies" = {
      namespace  = "argocd"
      project    = "platform"
      finalizers = ["resources-finalizer.argocd.argoproj.io"]
      source = {
        repoURL        = var.git_repo_url
        targetRevision = var.git_revision
        path           = "platform/policies"
      }
      destination = { server = "https://kubernetes.default.svc", namespace = "kyverno" }
      syncPolicy  = { automated = { prune = true, selfHeal = true }, retry = local.retry }
    }
  })

  # Slack: sync failures, degraded health, and every successful deploy (once per revision).
  # Each body is built with printf | toJson, so quotes in error messages cannot break the JSON.
  slack_body = {
    "app-sync-failed"     = "{\"text\": {{ printf \":x: *%s* sync failed: %s\" .app.metadata.name .app.status.operationState.message | toJson }}}"
    "app-health-degraded" = "{\"text\": {{ printf \":warning: *%s* is Degraded (revision %s)\" .app.metadata.name (.app.status.sync.revision | trunc 7) | toJson }}}"
    "app-deployed"        = "{\"text\": {{ printf \":rocket: *%s* deployed revision %s\" .app.metadata.name (.app.status.sync.revision | trunc 7) | toJson }}}"
  }
  notifications = {
    enabled = true
    secret  = { items = { "slack-webhook-url" = var.slack_webhook_url } }
    notifiers = {
      "service.webhook.slack-webhook" = yamlencode({
        url     = "$slack-webhook-url"
        headers = [{ name = "Content-Type", value = "application/json" }]
      })
    }
    templates = { for name, body in local.slack_body : "template.${name}" => yamlencode({
      webhook = { "slack-webhook" = { method = "POST", body = body } }
    }) }
    triggers = {
      "trigger.on-sync-failed"     = yamlencode([{ when = "app.status.operationState != nil and app.status.operationState.phase in ['Error', 'Failed']", send = ["app-sync-failed"] }])
      "trigger.on-health-degraded" = yamlencode([{ when = "app.status.health.status == 'Degraded'", send = ["app-health-degraded"] }])
      "trigger.on-deployed" = yamlencode([{
        when    = "app.status.operationState != nil and app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'"
        oncePer = "app.status.sync.revision"
        send    = ["app-deployed"]
      }])
    }
    subscriptions = [{
      recipients = ["slack-webhook:caresignal"]
      triggers   = ["on-sync-failed", "on-health-degraded", "on-deployed"]
    }]
  }
}

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argocd_chart_version
  namespace        = "argocd"
  create_namespace = true
  timeout          = 600

  # Slack notifications only when a webhook is configured (a second values document)
  values = concat([local.server_values], local.slack_enabled ? [yamlencode({ notifications = local.notifications })] : [])
}

# Only needed when the Git repository is private
resource "kubernetes_secret_v1" "repo" {
  count = nonsensitive(var.git_repo_token == "") ? 0 : 1

  metadata {
    name      = "caresignal-repo"
    namespace = "argocd"
    labels    = { "argocd.argoproj.io/secret-type" = "repository" }
  }

  data = {
    type     = "git"
    url      = var.git_repo_url
    username = var.git_repo_username
    password = var.git_repo_token
  }

  depends_on = [helm_release.argocd]
}

resource "helm_release" "argocd_apps" {
  name       = "argocd-apps"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = var.argocd_apps_chart_version
  namespace  = "argocd"

  values = [yamlencode({
    projects = {
      # Applications: namespaced resources in their own namespaces only, no cluster-wide objects
      caresignal = {
        namespace   = "argocd"
        description = "CareSignal applications and the AIOps engine"
        sourceRepos = [var.git_repo_url]
        destinations = [for ns in ["caresignal-stage", "caresignal-prod", "aiops"] :
        { server = "https://kubernetes.default.svc", namespace = ns }]
        clusterResourceWhitelist   = []
        namespaceResourceWhitelist = [{ group = "*", kind = "*" }]
      }
      # Platform policies: only Kyverno policy objects, nothing else
      platform = {
        namespace                  = "argocd"
        description                = "Cluster policies (Kyverno), reviewed in Git"
        sourceRepos                = [var.git_repo_url]
        destinations               = [{ server = "https://kubernetes.default.svc", namespace = "kyverno" }]
        clusterResourceWhitelist   = [{ group = "kyverno.io", kind = "ClusterPolicy" }]
        namespaceResourceWhitelist = []
      }
    }
    applications = local.applications
  })]

  depends_on = [helm_release.argocd, kubernetes_secret_v1.repo]
}
