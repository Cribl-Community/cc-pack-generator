# Sanitised samples

Parser-validated customer samples whose identifying values were replaced locally.

- One JSON document per `sourcetype` or `sourcetype::format`.
- `index.json` is the manifest used by the app.
- Documents contain only sanitised events and validation evidence.
- Original events and original-to-alias mappings must never be written here.

This store is separate from `config/ai-samples/`: sanitised samples preserve a real
vendor wire format, while AI samples are synthetic.
