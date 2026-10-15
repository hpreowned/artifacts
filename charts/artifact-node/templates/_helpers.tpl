{{/*
Fail-fast validation. Called at the top of every template so a bad artifactId, a missing expiresAt, a
tag-only image or an empty/relative writablePaths list can never render anything, not even a partial
manifest -- same pattern as charts/artifact-python/templates/_helpers.tpl's "artifact-python.validate".
The artifactId regex mirrors contracts/intake-openapi.yaml's ArtifactId pattern. The image regex ties the
digest-pinned reference to this release's own artifactId, since pipelines/artifact-node-deploy.yml builds
one image per prototype (jfrog.corp.com/artifacts/node-<artifactId>), unlike the Python tier's single shared
runtime image.
*/}}
{{- define "artifact-node.validate" -}}
{{- if not (regexMatch "^[a-z0-9]{12}$" .Values.artifactId) -}}
{{- fail (printf "artifactId %q must match ^[a-z0-9]{12}$" .Values.artifactId) -}}
{{- end -}}
{{- if not .Values.expiresAt -}}
{{- fail "expiresAt is required" -}}
{{- end -}}
{{- if not (regexMatch (printf "^jfrog\\.corp\\.com/artifacts/node-%s@sha256:[a-f0-9]{64}$" .Values.artifactId) .Values.image) -}}
{{- fail (printf "image %q must be jfrog.corp.com/artifacts/node-%s@sha256:<64 hex>" .Values.image .Values.artifactId) -}}
{{- end -}}
{{- if not .Values.writablePaths -}}
{{- fail "writablePaths must not be empty" -}}
{{- end -}}
{{- range .Values.writablePaths -}}
{{- if not (hasPrefix "/" .) -}}
{{- fail (printf "writablePaths entry %q must be an absolute path" .) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* RFC 3339 expiresAt -> the fixed-width label/header form (':' -> '-' for labels; the header below uses
     the raw RFC 3339 value, since response headers have no ':' restriction). */}}
{{- define "artifact-node.expiresAtLabel" -}}
{{- .Values.expiresAt | replace ":" "-" -}}
{{- end -}}

{{/* Labels shared by every object in the release. */}}
{{- define "artifact-node.labels" -}}
artifacts.corp.com/id: {{ .Values.artifactId | quote }}
artifacts.corp.com/expires-at: {{ include "artifact-node.expiresAtLabel" . | quote }}
artifacts.corp.com/job: {{ .Values.jobId | quote }}
app.kubernetes.io/managed-by: Helm
{{- end -}}

{{- define "artifact-node.fullname" -}}
prototype-{{ .Values.artifactId }}
{{- end -}}

{{/* Deterministic Kubernetes volume name from an absolute writable path, e.g. /app/data -> app-data. */}}
{{- define "artifact-node.volName" -}}
{{- . | trimPrefix "/" | replace "/" "-" -}}
{{- end -}}

{{/* The exact §6.13 Content-Security-Policy, frame-ancestors pinned to .Values.shellOrigin. */}}
{{- define "artifact-node.csp" -}}
{{- printf "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors %s; form-action 'self'; base-uri 'none'; object-src 'none'" .Values.shellOrigin -}}
{{- end -}}
