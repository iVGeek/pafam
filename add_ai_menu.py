import re
with open('public/index.html', 'r') as f:
    content = f.read()
# The file has HTML-encoded & as &
old = '<a data-route="reports">Reports & Exports</a>'
# Try with HTML entity amp; 
old_amp = '<a data-route="reports">Reports & Exports</a>'
new = '<a data-route="reports">Reports & Exports</a>\n        <a data-route="ai-chat">AI Chat</a>'
# Replace the amp; version first
if old_amp in content:
    content = content.replace(old_amp, new)
    with open('public/index.html', 'w') as f:
        f.write(content)
    print('SUCCESS: AI Chat menu item added (replaced & with plain &)')
elif old in content:
    content = content.replace(old, new)
    with open('public/index.html', 'w') as f:
        f.write(content)
    print('SUCCESS: AI Chat menu item added (plain &)')
else:
    print('FAILED: Could not find target string')
    lines = content.split('\n')
    for i, line in enumerate(lines[38:43], start=39):
        print(f'{i}: {repr(line)}')