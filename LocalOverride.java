import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a field as owned by our own app rather than the external service (CMiC360).
 * ObjectToBase64Util keeps these fields in the base64 snapshot even when their type
 * isn't "simple", and restorePreserved() copies them back onto a freshly-fetched
 * object so a CMiC360 refresh never clobbers app-only data.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.FIELD)
public @interface LocalOverride {
}
