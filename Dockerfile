FROM python:3.12-slim

WORKDIR /app

# Install deps first (cache layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY app.py battle.py judge.py ./
COPY static ./static

ENV PORT=8765
EXPOSE 8765

CMD ["python", "app.py"]
