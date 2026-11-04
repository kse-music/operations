ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server nginx python3 \
    && adduser --disabled-password --gecos '' --shell /bin/sh plugin \
    && rm -rf /var/lib/apt/lists/*
COPY sshd_config /etc/ssh/serverdeck_sshd_config
COPY entrypoint.sh /usr/local/bin/serverdeck-test-host
RUN sed -i 's/\r$//' /usr/local/bin/serverdeck-test-host /etc/ssh/serverdeck_sshd_config \
    && chmod 755 /usr/local/bin/serverdeck-test-host
EXPOSE 22 8080
ENTRYPOINT ["/usr/local/bin/serverdeck-test-host"]
