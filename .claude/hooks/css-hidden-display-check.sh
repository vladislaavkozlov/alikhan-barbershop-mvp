#!/bin/bash
payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')
case "$file" in
  *.css) ;;
  *) exit 0 ;;
esac
content=$(printf '%s' "$payload" | jq -r '.tool_input.new_string // .tool_input.content // empty')
if printf '%s' "$content" | grep -qE 'display[[:space:]]*:'; then
  jq -n --arg file "$file" '{
    systemMessage: "CSS: в \($file) добавлен display: — если этот класс переключается через element.hidden в JS, добавь явно .class[hidden]{display:none} (иначе UA-дефолт [hidden]{display:none} перебивается собственным display того же класса). Память: reference_css-hidden-attribute-display-conflict.md.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Напоминание (авто-хук, проект barbershop-alikhan-mvp): правишь CSS с display: в \($file). Если этот класс переключается через element.hidden = true/false в JS этого проекта — обязательно добавь .class[hidden]{display:none} явно, иначе UA-дефолт [hidden]{display:none} будет перебит собственным display того же класса (найдено дважды: login-gate 28.07.2026, appt--slot-preview 07.08.2026, см. память reference_css-hidden-attribute-display-conflict.md). Если этот класс не toggle-элемент — игнорируй."
    }
  }'
fi
exit 0
