# osgeo/gdal:ubuntu-full ships GDAL compiled with full driver support
# including PDF + GEO_ENCODING=OGC required by Avenza Maps.
# python:3.12-slim + apt gdal-bin does NOT include PDF driver — avoid it.
FROM ghcr.io/osgeo/gdal:ubuntu-full-latest

# Install Python 3.12, pip, Node.js 20
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Use venv to avoid PEP 668 "externally managed" error on Ubuntu
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Build frontend
COPY frontend/package.json frontend/package-lock.json* /app/frontend/
RUN cd /app/frontend && npm install

COPY frontend/ /app/frontend/
RUN cd /app/frontend && npm run build

# Install Python deps
COPY backend/requirements.txt /app/backend/
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/ /app/backend/

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]