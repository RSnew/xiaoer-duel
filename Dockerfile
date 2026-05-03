FROM python:3.12-slim

WORKDIR /app

# Install deps first (cache layer)
# Use a fast mirror; PYPI_INDEX can be overridden at build time via --build-arg
ARG PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
COPY requirements.txt .
RUN pip install --no-cache-dir -i "$PYPI_INDEX" -r requirements.txt

# Copy app
COPY app.py battle.py judge.py ./
COPY static ./static

ENV PORT=8765
EXPOSE 8765

CMD ["python", "app.py"]
