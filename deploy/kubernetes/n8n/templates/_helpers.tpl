{{/* The name of the release objects. */}}
{{- define "n8n.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "n8n.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* The selector labels of a component: main or worker. */}}
{{- define "n8n.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "n8n.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "n8n.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The port of the pod that the Service and the probes of the main instances use. */}}
{{- define "n8n.httpPort" -}}
{{- if .Values.edge.enabled -}}edge{{- else -}}http{{- end -}}
{{- end -}}

{{/* Stops the render with a clear message when a required value is missing. */}}
{{- define "n8n.validate" -}}
{{- if not .Values.host -}}
{{- fail "Set host to the host name of n8n, for example n8n.example.com." -}}
{{- end -}}
{{- if not .Values.existingSecret -}}
{{- fail "Set existingSecret to the Secret with N8N_ENCRYPTION_KEY, N8N_RUNNERS_AUTH_TOKEN and DB_POSTGRESDB_PASSWORD (see README.md)." -}}
{{- end -}}
{{- if not .Values.database.host -}}
{{- fail "Set database.host to the host of PostgreSQL." -}}
{{- end -}}
{{- if not (has .Values.mode (list "single" "queue")) -}}
{{- fail "Set mode to single or queue." -}}
{{- end -}}
{{- if and (eq .Values.mode "single") (gt (int .Values.main.replicas) 1) -}}
{{- fail "mode single runs one n8n instance. Use mode queue for more main instances." -}}
{{- end -}}
{{- if and (eq .Values.mode "queue") (not .Values.redis.host) -}}
{{- fail "mode queue needs redis.host." -}}
{{- end -}}
{{- if and .Values.edge.enabled (not .Values.edge.trustedProxies) -}}
{{- fail "Set edge.trustedProxies to the addresses of the proxies in front of n8n, for example the pod range of the cluster." -}}
{{- end -}}
{{- if and .Values.ingress.enabled .Values.httpRoute.enabled -}}
{{- fail "Turn on ingress or httpRoute, not both." -}}
{{- end -}}
{{- end -}}

{{/*
The containers of an n8n pod: n8n (main or worker), the task runners and, on the main instances,
the edge proxy. The argument is a dict with root, component (main or worker) and resources.
*/}}
{{- define "n8n.containers" -}}
{{- $root := .root -}}
{{- $values := $root.Values -}}
{{- $worker := eq .component "worker" -}}
- name: n8n
  image: "{{ $values.image.repository }}:{{ $values.image.tag }}"
  imagePullPolicy: {{ $values.image.pullPolicy }}
  {{- if $worker }}
  args: ["worker", "--concurrency={{ $values.worker.concurrency }}"]
  {{- end }}
  envFrom:
    - configMapRef:
        name: {{ include "n8n.fullname" $root }}-env
  env:
    {{- range $name := list "N8N_ENCRYPTION_KEY" "N8N_RUNNERS_AUTH_TOKEN" "DB_POSTGRESDB_PASSWORD" }}
    - name: {{ $name }}
      valueFrom:
        secretKeyRef:
          name: {{ $values.existingSecret }}
          key: {{ $name }}
    {{- end }}
    {{- range $name := list "QUEUE_BULL_REDIS_PASSWORD" "N8N_SSO_OIDC_CLIENT_SECRET" "N8N_COMMUNITY_PACKAGES_AUTH_TOKEN" "N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN" }}
    - name: {{ $name }}
      valueFrom:
        secretKeyRef:
          name: {{ $values.existingSecret }}
          key: {{ $name }}
          optional: true
    {{- end }}
  ports:
    - name: http
      containerPort: 5678
  {{- /* A probe can name only a port of its own container, so it takes the number of the edge port. */}}
  {{- $probePort := ternary 5678 (ternary 8080 5678 $values.edge.enabled) $worker }}
  # The first start runs the migrations of the database, so it can take some minutes.
  startupProbe:
    httpGet:
      path: /healthz
      port: {{ $probePort }}
    periodSeconds: 5
    failureThreshold: 120
  readinessProbe:
    httpGet:
      path: /healthz/readiness
      port: {{ $probePort }}
    periodSeconds: 10
  livenessProbe:
    httpGet:
      path: /healthz
      port: {{ $probePort }}
    periodSeconds: 20
    failureThreshold: 6
  resources:
    {{- toYaml .resources | nindent 4 }}
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
  volumeMounts:
    # Only data that n8n can make again: the Git working copies, the community nodes and caches.
    - name: data
      mountPath: /home/node/.n8n
    {{- if $values.gitCaCertificate.secretName }}
    - name: git-ca
      mountPath: /etc/n8n-git-ca
      readOnly: true
    {{- end }}
- name: runners
  image: "{{ $values.runnersImage.repository }}:{{ $values.runnersImage.tag }}"
  imagePullPolicy: {{ $values.runnersImage.pullPolicy }}
  env:
    - name: N8N_RUNNERS_TASK_BROKER_URI
      value: http://127.0.0.1:5679
    - name: N8N_RUNNERS_AUTH_TOKEN
      valueFrom:
        secretKeyRef:
          name: {{ $values.existingSecret }}
          key: N8N_RUNNERS_AUTH_TOKEN
    - name: GENERIC_TIMEZONE
      value: {{ index $values.settings "GENERIC_TIMEZONE" | quote }}
    # A runner without work for 15 seconds stops. The launcher starts it again for the next task.
    - name: N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT
      value: "15"
  resources:
    {{- toYaml $values.runners.resources | nindent 4 }}
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
{{- if and $values.edge.enabled (not $worker) }}
- name: edge
  image: "{{ $values.edge.image.repository }}:{{ $values.edge.image.tag }}"
  imagePullPolicy: {{ $values.edge.image.pullPolicy }}
  args: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
  ports:
    - name: edge
      containerPort: 8080
  readinessProbe:
    tcpSocket:
      port: edge
    periodSeconds: 10
  resources:
    {{- toYaml $values.edge.resources | nindent 4 }}
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
      # The caddy binary of the image has this file capability. Without it, it does not start.
      add: ["NET_BIND_SERVICE"]
  volumeMounts:
    - name: edge-config
      mountPath: /etc/caddy
      readOnly: true
    - name: edge-data
      mountPath: /data
    - name: edge-state
      mountPath: /config
{{- end }}
{{- end -}}

{{/* The volumes of an n8n pod. The argument is a dict with root and component. */}}
{{- define "n8n.volumes" -}}
{{- $root := .root -}}
{{- $values := $root.Values -}}
- name: data
  emptyDir: {}
{{- if $values.gitCaCertificate.secretName }}
- name: git-ca
  secret:
    secretName: {{ $values.gitCaCertificate.secretName }}
{{- end }}
{{- if and $values.edge.enabled (eq .component "main") }}
- name: edge-config
  configMap:
    name: {{ include "n8n.fullname" $root }}-edge
- name: edge-data
  emptyDir: {}
- name: edge-state
  emptyDir: {}
{{- end }}
{{- end -}}

{{/* The pod settings that the main instances and the workers share. */}}
{{- define "n8n.podSpec" -}}
{{- $values := .Values -}}
serviceAccountName: {{ include "n8n.serviceAccountName" . }}
# n8n does not call the API of Kubernetes.
automountServiceAccountToken: false
{{- with $values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
# n8n stops within 30 seconds (N8N_GRACEFUL_SHUTDOWN_TIMEOUT) and lets running executions finish.
terminationGracePeriodSeconds: 60
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
{{- with $values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
