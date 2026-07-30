import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
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
     * Returns a shallow copy of obj (same class, built via its no-arg constructor)
     * with every simple-type field copied over and every non-simple-type field
     * left at its default (null for objects, since the fresh instance never sets
     * them).
     */
    @SuppressWarnings("unchecked")
    public static <T> T filterSimpleFields(T obj) {
        if (obj == null) {
            return null;
        }
        Class<T> clazz = (Class<T>) obj.getClass();
        try {
            Constructor<T> noArgCtor = clazz.getDeclaredConstructor();
            noArgCtor.setAccessible(true);
            T copy = noArgCtor.newInstance();

            // Walk up the class hierarchy in case of inherited fields
            Class<?> current = clazz;
            while (current != null && current != Object.class) {
                for (Field field : current.getDeclaredFields()) {
                    if (Modifier.isStatic(field.getModifiers()) || !isSimpleType(field.getType())) {
                        continue;
                    }
                    field.setAccessible(true);
                    field.set(copy, field.get(obj));
                }
                current = current.getSuperclass();
            }
            return copy;
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException("Failed to filter simple fields for " + clazz.getName(), e);
        }
    }

    /*
     * ==== Real project version (uncomment once Jackson is on the classpath) ====
     */
      public static <T> String toBase64(T obj) throws com.fasterxml.jackson.core.JsonProcessingException {
          T filtered = filterSimpleFields(obj);
          com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
          // Fields stay private with no getters, so tell Jackson to read them directly
          mapper.setVisibility(com.fasterxml.jackson.annotation.PropertyAccessor.FIELD,
              com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility.ANY);
          String json = mapper.writeValueAsString(filtered);
          return Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
      }
     
      public static <T> T fromBase64(String base64, Class<T> targetType) throws com.fasterxml.jackson.core.JsonProcessingException {
          byte[] decoded = Base64.getDecoder().decode(base64);
          String json = new String(decoded, StandardCharsets.UTF_8);
          com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
          mapper.setVisibility(com.fasterxml.jackson.annotation.PropertyAccessor.FIELD,
              com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility.ANY);
          return mapper.readValue(json, targetType);
      }
    

}