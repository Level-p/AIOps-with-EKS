{{/* Labels shared by every object */}}
{{- define "caresignal.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: caresignal
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
caresignal/environment: {{ .root.Values.global.environment }}
{{- end }}

{{- define "caresignal.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{/* <registry>/<repository>:<tag>; the tag is the commit SHA written by the pipeline */}}
{{- define "caresignal.image" -}}
{{- $registry := .root.Values.global.imageRegistry -}}
{{- if $registry -}}
{{ printf "%s/%s:%s" $registry .svc.image (toString .svc.tag) }}
{{- else -}}
{{ printf "%s:%s" .svc.image (toString .svc.tag) }}
{{- end -}}
{{- end }}

{{/* Secret the postgres-operator creates for a database user */}}
{{- define "caresignal.dbSecret" -}}
{{ printf "%s.%s.credentials.postgresql.acid.zalan.do" .user .root.Values.postgres.clusterName }}
{{- end }}

{{/* Passes the "restricted" Pod Security Standard */}}
{{- define "caresignal.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .readOnly }}
runAsNonRoot: true
capabilities:
  drop: ["ALL"]
{{- end }}
