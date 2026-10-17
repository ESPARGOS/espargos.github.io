#!/usr/bin/env python3
"""Describe the exact recovery images deployed by this build."""
import hashlib
import json
from pathlib import Path

site = Path(__file__).resolve().parents[1]
channels = {}
for channel in ('stable', 'testing', 'dev'):
    folder = site / 'content/firmware' / channel
    image = folder / 'espargos-controller-recovery.bin'
    if not image.exists():
        continue
    data = image.read_bytes()
    if len(data) != 16 * 1024 * 1024 or data[0x1000] != 0xE9:
        raise ValueError(f'{image}: expected a 16 MB ESP32 recovery image')
    metadata = json.loads((folder / 'espargos-controller-artifact.json').read_text())
    channels[channel] = {
        'path': f'{channel}/{image.name}',
        'size': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
        'md5': hashlib.md5(data).hexdigest(),
        'build_date': metadata['build_date'],
        'version': metadata['build_version'],
    }
if not channels:
    raise ValueError('No recovery images available')
output = site / 'static/recovery-flasher/firmware.json'
output.write_text(json.dumps({'channels': channels}, indent=2) + '\n')
print(f'Recovery catalog: {", ".join(channels)}')
