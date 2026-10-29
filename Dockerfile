FROM python:3.12-slim
WORKDIR /app
ARG XRAY_VERSION=v26.10.29
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-driver ca-certificates curl unzip \
    && curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" -o /tmp/xray.zip \
    && unzip -p /tmp/xray.zip xray > /usr/local/bin/xray \
    && chmod 0755 /usr/local/bin/xray \
    && rm -f /tmp/xray.zip \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py vless_proxy.py ./
COPY static ./static
ENV PORT=8000
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER=/usr/bin/chromedriver
ENV XRAY_BIN=/usr/local/bin/xray
EXPOSE 8000
CMD ["sh","-c","uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
