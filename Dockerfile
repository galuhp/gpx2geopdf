FROM python:3.12-slim

# Install GDAL, Node.js, and ImageMagick
RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    curl \
    imagemagick \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/<policy domain="coder" rights="none" pattern="SVG" \/>/<!-- SVG enabled -->/' /etc/ImageMagick-6/policy.xml 2>/dev/null || true \
    && sed -i 's|rights="none" pattern="\*"|rights="read|write" pattern="*"|g' /etc/ImageMagick-6/policy.xml 2>/dev/null || true

WORKDIR /app

# Build frontend
COPY frontend/package.json frontend/package-lock.json* /app/frontend/
RUN cd /app/frontend && npm install

COPY frontend/ /app/frontend/
RUN cd /app/frontend && npm run build

# Install Python deps
COPY backend/requirements.txt /app/backend/
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# v7.3 — pure-PIL icon renderer, save/load project
COPY backend/ /app/backend/

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
