FROM python:3.12-slim

# Install GDAL and Node.js
RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

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
