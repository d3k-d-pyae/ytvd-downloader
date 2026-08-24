FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY public ./public

ENV PYTHONUNBUFFERED=1 \
    PORT=5000

EXPOSE 5000

CMD ["python", "app.py"]
