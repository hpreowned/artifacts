{{/*
Fail-fast validation. Called at the top of every template so a bad artifactId or entrypoint can never render
anything, not even a partial manifest. The regex mirrors contracts/intake-openapi.yaml's ArtifactId pattern
and the same `streamlit|fastapi` set render.sh used to accept.
*/}}
{{- define "artifact-python.validate" -}}
{{- if not (regexMatch "^[a-z0-9]{12}$" .Values.artifactId) -}}
{{- fail (printf "artifactId %q must match ^[a-z0-9]{12}$" .Values.artifactId) -}}
{{- end -}}
{{- if not (or (eq .Values.entrypoint "streamlit") (eq .Values.entrypoint "fastapi")) -}}
{{- fail (printf "entrypoint %q must be streamlit or fastapi" .Values.entrypoint) -}}
{{- end -}}
{{- if not .Values.expiresAt -}}
{{- fail "expiresAt is required" -}}
{{- end -}}
{{- if not (regexMatch "^jfrog\\.corp\\.com/artifacts/python-runtime@sha256:[a-f0-9]{64}$" .Values.image) -}}
{{- fail (printf "image %q must be jfrog.corp.com/artifacts/python-runtime@sha256:<64 hex>" .Values.image) -}}
{{- end -}}
{{- end -}}

{{/* RFC 3339 expiresAt -> the fixed-width label form render.sh used: ':' -> '-'. */}}
{{- define "artifact-python.expiresAtLabel" -}}
{{- .Values.expiresAt | replace ":" "-" -}}
{{- end -}}

{{/* Entrypoint args, identical to tests/runtime-manifest.python-1.json. */}}
{{- define "artifact-python.args" -}}
{{- if eq .Values.entrypoint "streamlit" -}}
["streamlit", "run", "/app/app.py", "--server.port=8080", "--server.address=0.0.0.0", "--server.headless=true", "--browser.gatherUsageStats=false"]
{{- else -}}
["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app"]
{{- end -}}
{{- end -}}

{{/* Labels shared by every object in the release. */}}
{{- define "artifact-python.labels" -}}
artifacts.corp.com/id: {{ .Values.artifactId | quote }}
artifacts.corp.com/expires-at: {{ include "artifact-python.expiresAtLabel" . | quote }}
artifacts.corp.com/job: {{ .Values.jobId | quote }}
app.kubernetes.io/managed-by: Helm
{{- end -}}

{{- define "artifact-python.fullname" -}}
art-{{ .Values.artifactId }}
{{- end -}}
