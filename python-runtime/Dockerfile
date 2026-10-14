# Curated Python runtime for the dynamic tier, DESIGN §6.5, D6. Built by pipelines/platform-deploy.yml,
# pushed to jfrog.corp.com/artifacts/python-runtime, referenced by digest only (Azure Policy regex).
# The artifact's app.py is mounted at /app from a ConfigMap; args come from the rendered Deployment
# (runtime-manifest.json "entrypoints"), so there is no ENTRYPOINT or CMD.
#
# Pins below are known-good releases as of writing; CI is the source of truth: the build fails if a pin is
# not on the JFrog PyPI mirror, and runtime-manifest.json records what was actually installed.
FROM jfrog.corp.com/docker/python:3.12-slim AS build

RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir \
      streamlit==1.45.1 \
      fastapi==0.115.12 \
      uvicorn==0.34.3 \
      pandas==2.3.0 \
      numpy==2.3.0 \
      plotly==6.1.2 \
      altair==5.5.0 \
      pydantic==2.11.5 \
      starlette==0.46.2

COPY emit-manifest.py /tmp/emit-manifest.py
RUN /venv/bin/pip list --format json \
      | python3 /tmp/emit-manifest.py --image jfrog.corp.com/artifacts/python-runtime > /runtime-manifest.json \
 && cat /runtime-manifest.json

FROM jfrog.corp.com/docker/python:3.12-slim

COPY --from=build /venv /venv
COPY --from=build /runtime-manifest.json /runtime-manifest.json
RUN addgroup --system --gid 65532 app \
 && adduser --system --ingroup app --uid 65532 --home /tmp --no-create-home app
USER 65532
ENV PATH="/venv/bin:$PATH" \
    HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false
WORKDIR /app
EXPOSE 8080
