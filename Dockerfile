FROM python:3.12-slim

RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Debian trixie ships Node 20, which yt-dlp rejects for JS challenge solving
RUN curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz \
    | tar -xJ --strip-components=1 -C /usr/local

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY public ./public

ENV PYTHONUNBUFFERED=1 \
    PORT=5000

EXPOSE 5000

CMD ["python", "app.py"]
