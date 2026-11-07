import re
with open('C:/iVGeek/perfume-trading-platform/public/index.html', 'r') as f:
    content = f.read()
# The file has HTML-encoded & as &
old = '<a data-route="reports">Reports & Exports</a>'
new = '<a data-route="reports">Reports & Exports</a>\n        <a data-route="ai-chat">AI Chat</a>'
if old in content:
    content = content.replace(old, new)
    with open('C:/iVGeek/perfume-trading-platform/public/index.html', 'w') as f:
        f.write(content)
    print('SUCCESS: AI Chat menu item added')
else:
    print('FAILED: Could not find the target string')
    lines = content.split('\n')
    for i, line in enumerate(lines[38:43], start=39):
        print(f'{i}: {repr(line)}')