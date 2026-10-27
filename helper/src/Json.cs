// Minimal dependency-free JSON writer/reader (C# 5 compatible).
// Used for the line-based command protocol and JSON frames. Kept intentionally small.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VibeDeck.Helper
{
    internal static class Json
    {
        public static string Serialize(object value)
        {
            var sb = new StringBuilder(256);
            Write(sb, value);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object v)
        {
            if (v == null) { sb.Append("null"); return; }
            var s = v as string;
            if (s != null) { WriteString(sb, s); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is int || v is long || v is uint || v is ulong || v is short || v is ushort || v is byte || v is sbyte)
            {
                sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                return;
            }
            if (v is double)
            {
                var d = (double)v;
                if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (v is float) { Write(sb, (double)(float)v); return; }
            if (v is decimal) { sb.Append(((decimal)v).ToString(CultureInfo.InvariantCulture)); return; }
            var dict = v as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (var kv in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    Write(sb, kv.Value);
                }
                sb.Append('}');
                return;
            }
            var list = v as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item);
                }
                sb.Append(']');
                return;
            }
            WriteString(sb, v.ToString());
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ------------------------------------------------------------------
        // Parser
        // ------------------------------------------------------------------

        public static Dictionary<string, object> ParseObject(string text)
        {
            int i = 0;
            var v = ParseValue(text, ref i);
            SkipWs(text, ref i);
            return v as Dictionary<string, object>;
        }

        private static void SkipWs(string t, ref int i)
        {
            while (i < t.Length && (t[i] == ' ' || t[i] == '\t' || t[i] == '\r' || t[i] == '\n')) i++;
        }

        private static object ParseValue(string t, ref int i)
        {
            SkipWs(t, ref i);
            if (i >= t.Length) throw new FormatException("Unexpected end of JSON");
            char c = t[i];
            if (c == '{') return ParseObj(t, ref i);
            if (c == '[') return ParseArr(t, ref i);
            if (c == '"') return ParseStr(t, ref i);
            if (c == 't') { Expect(t, ref i, "true"); return true; }
            if (c == 'f') { Expect(t, ref i, "false"); return false; }
            if (c == 'n') { Expect(t, ref i, "null"); return null; }
            return ParseNum(t, ref i);
        }

        private static void Expect(string t, ref int i, string word)
        {
            if (i + word.Length > t.Length || string.CompareOrdinal(t, i, word, 0, word.Length) != 0)
                throw new FormatException("Invalid JSON literal at " + i);
            i += word.Length;
        }

        private static Dictionary<string, object> ParseObj(string t, ref int i)
        {
            var d = new Dictionary<string, object>();
            i++; // {
            SkipWs(t, ref i);
            if (i < t.Length && t[i] == '}') { i++; return d; }
            while (true)
            {
                SkipWs(t, ref i);
                if (i >= t.Length || t[i] != '"') throw new FormatException("Expected string key at " + i);
                var key = ParseStr(t, ref i);
                SkipWs(t, ref i);
                if (i >= t.Length || t[i] != ':') throw new FormatException("Expected ':' at " + i);
                i++;
                var val = ParseValue(t, ref i);
                d[key] = val;
                SkipWs(t, ref i);
                if (i >= t.Length) throw new FormatException("Unterminated object");
                if (t[i] == ',') { i++; continue; }
                if (t[i] == '}') { i++; return d; }
                throw new FormatException("Expected ',' or '}' at " + i);
            }
        }

        private static List<object> ParseArr(string t, ref int i)
        {
            var l = new List<object>();
            i++; // [
            SkipWs(t, ref i);
            if (i < t.Length && t[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(ParseValue(t, ref i));
                SkipWs(t, ref i);
                if (i >= t.Length) throw new FormatException("Unterminated array");
                if (t[i] == ',') { i++; continue; }
                if (t[i] == ']') { i++; return l; }
                throw new FormatException("Expected ',' or ']' at " + i);
            }
        }

        private static string ParseStr(string t, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (i < t.Length)
            {
                char c = t[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= t.Length) break;
                char e = t[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > t.Length) throw new FormatException("Bad unicode escape");
                        sb.Append((char)int.Parse(t.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("Bad escape \\" + e);
                }
            }
            throw new FormatException("Unterminated string");
        }

        private static object ParseNum(string t, ref int i)
        {
            int start = i;
            while (i < t.Length && ("+-0123456789.eE".IndexOf(t[i]) >= 0)) i++;
            var s = t.Substring(start, i - start);
            if (s.Length == 0) throw new FormatException("Unexpected character at " + start);
            long l;
            if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out l)) return l;
            double d;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            throw new FormatException("Bad number '" + s + "'");
        }

        // Helpers for command dictionaries
        public static string GetString(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null) return v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture);
            return null;
        }
    }
}
