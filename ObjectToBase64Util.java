import java.lang.reflect.Field;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Production version — uses Jackson's ObjectMapper (com.fasterxml.jackson.databind).
 * Jackson serializes enums as their name(), BigDecimal as a numeric literal, and
 * Date as an epoch-millis timestamp by default — no extra module needed for any
 * of the types kept below.
 */
public class ObjectToBase64Util {

    // Types we consider "primitive-ish" / safe for flat storage
    private static final Set<Class<?>> SIMPLE_TYPES = new HashSet<>(Arrays.asList(
        Integer.class, Long.class, Double.class, Float.class,
        Boolean.class, Byte.class, Short.class, Character.class,
        String.class, BigDecimal.class, Date.class
    ));

    private static boolean isSimpleType(Class<?> type) {
        return type.isPrimitive()
            || type.isEnum()
            || SIMPLE_TYPES.contains(type);
    }

    /**
     * Extracts only primitive/wrapper/String/enum/BigDecimal/Date fields from the
     * object, serializes them to JSON, and Base64-encodes the result.
     */
    public static Map<String, Object> filterSimpleFields(Object obj) {
        Map<String, Object> filtered = new LinkedHashMap<>();
        Class<?> clazz = obj.getClass();

        // Walk up the class hierarchy in case of inherited fields
        while (clazz != null && clazz != Object.class) {
            for (Field field : clazz.getDeclaredFields()) {
                if (isSimpleType(field.getType())) {
                    field.setAccessible(true);
                    try {
                        Object value = field.get(obj);
                        // Store enums as their name so the JSON stays plain-text
                        if (value instanceof Enum) {
                            value = ((Enum<?>) value).name();
                        }
                        filtered.put(field.getName(), value);
                    } catch (IllegalAccessException e) {
                        throw new RuntimeException("Failed to read field: " + field.getName(), e);
                    }
                }
            }
            clazz = clazz.getSuperclass();
        }
        return filtered;
    }

    /*
     * ==== Real project version (uncomment once Jackson is on the classpath) ====
     *
     * public static String toBase64(Object obj) throws com.fasterxml.jackson.core.JsonProcessingException {
     *     Map<String, Object> filtered = filterSimpleFields(obj);
     *     com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
     *     String json = mapper.writeValueAsString(filtered);
     *     return Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
     * }
     *
     * public static Map<String, Object> fromBase64(String base64) throws com.fasterxml.jackson.core.JsonProcessingException {
     *     byte[] decoded = Base64.getDecoder().decode(base64);
     *     String json = new String(decoded, StandardCharsets.UTF_8);
     *     com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
     *     return mapper.readValue(json, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
     * }
     */

    // ==== Sandbox-only stand-ins so this file compiles/runs without Jackson on the classpath ====

    public static String toBase64(Object obj) {
        Map<String, Object> filtered = filterSimpleFields(obj);
        String json = MiniJson.toJson(filtered);
        return Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    public static String decodeToJson(String base64) {
        byte[] decoded = Base64.getDecoder().decode(base64);
        return new String(decoded, StandardCharsets.UTF_8);
    }
}