import json
import argparse

# 设置命令行参数解析
parser = argparse.ArgumentParser(description='Update version in JSON file.')
parser.add_argument('file', help='The JSON file to update.')
parser.add_argument('version', help='The version number to set.')
args = parser.parse_args()

# 读取 JSON 文件
with open(args.file, 'r', encoding='utf-8') as file:
    data = json.load(file)

# 修改与 "name" 同层级的 "version" 值
if 'version' in data:
    data['version'] = args.version

# 将修改后的 JSON 数据写回文件
with open(args.file, 'w', encoding='utf-8') as file:
    json.dump(data, file, indent=2)
