"""Isolated key-auth SSH fixture; real commands execute in a disposable WSL directory."""
import base64
import json
import os
import socket
import subprocess
import sys
import threading

sys.path.insert(0, os.path.abspath('analysis/ssh-deps'))
import paramiko

key_file, distro = sys.argv[1:3]
with open(key_file, encoding='utf-8') as source:
    public_key = source.read().split()[1]
host_key = paramiko.RSAKey.generate(2048)


class Server(paramiko.ServerInterface):
    def get_allowed_auths(self, username):
        return 'publickey'

    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL if username == 'notch-test' and key.get_base64() == public_key else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        def execute():
            data = bytearray()
            while True:
                chunk = channel.recv(65536)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 16 * 1024 * 1024:
                    channel.close()
                    return
            try:
                child = subprocess.run(['wsl.exe', '-d', distro, '--exec', '/bin/sh', '-c', command.decode('utf-8')], input=data, capture_output=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
                if child.stdout:
                    channel.sendall(child.stdout)
                if child.stderr:
                    channel.sendall_stderr(child.stderr)
                channel.send_exit_status(child.returncode)
            except Exception as error:
                channel.sendall_stderr(str(error).encode())
                channel.send_exit_status(1)
            finally:
                channel.close()
        threading.Thread(target=execute, daemon=True).start()
        return True


listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(10)
print(json.dumps({'port': listener.getsockname()[1], 'hostKey': host_key.get_name() + ' ' + host_key.get_base64()}), flush=True)


def connection(client):
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    channels = []
    try:
        transport.start_server(server=Server())
        while transport.is_active():
            channel = transport.accept(1)
            if channel is not None:
                channels.append(channel)
            channels = [channel for channel in channels if not channel.closed]
    finally:
        transport.close()


while True:
    client, _ = listener.accept()
    threading.Thread(target=connection, args=(client,), daemon=True).start()
