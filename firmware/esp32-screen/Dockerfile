# The pinned ESP-IDF toolchain. ./idf builds it the first time.
FROM espressif/idf:v5.5.5

# The project is mounted with the host's uid; git inside /opt/esp/idf (owned
# by root) would say "dubious ownership" without this.
RUN git config --system --add safe.directory '*'
