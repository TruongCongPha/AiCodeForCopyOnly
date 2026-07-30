import java.math.BigDecimal;
import java.util.*;

public class TestRun {
    public static void main(String[] args) {
        Map<String, Object> dataType = new HashMap<>();
        dataType.put("nested", new Object());

        Map<String, Boolean> dataType2 = new HashMap<>();
        dataType2.put("flag", true);

        CMiCClaim claim = new CMiCClaim(
            new ClaimCanonical(),          // canonical - nested object, expect filtered out
            "Water Damage Claim",          // name
            "Pipe burst in kitchen",       // description
            true,                          // isActive
            42,                            // count
            123456789L,                    // numbers
            9999.99,                       // amount
            new BigDecimal("18500.75"),    // total
            new Date(1735689600000L),      // createdDate (fixed timestamp for reproducibility)
            CMiCClaim.ClaimStatus.PENDING, // status (enum)
            dataType,                      // expect filtered out
            dataType2,                     // expect filtered out
            Arrays.asList("urgent", "kitchen") // tags, expect filtered out
        );

        // 1. Filtered field map
        Map<String, Object> filtered = ObjectToBase64Util.filterSimpleFields(claim);
        System.out.println("=== Filtered fields ===");
        for (Map.Entry<String, Object> e : filtered.entrySet()) {
            System.out.println("  " + e.getKey() + " = " + e.getValue() + "  (" + (e.getValue() == null ? "null" : e.getValue().getClass().getSimpleName()) + ")");
        }

        // Assertions: excluded fields must NOT be present
        String[] mustNotContain = {"canonical", "dataType", "dataType2", "tags"};
        boolean allExcludedOk = true;
        for (String key : mustNotContain) {
            if (filtered.containsKey(key)) {
                System.out.println("  FAIL: '" + key + "' should have been excluded but was present!");
                allExcludedOk = false;
            }
        }

        // Assertions: included fields MUST be present
        String[] mustContain = {"name", "description", "isActive", "count", "numbers", "amount", "total", "createdDate", "status"};
        boolean allIncludedOk = true;
        for (String key : mustContain) {
            if (!filtered.containsKey(key)) {
                System.out.println("  FAIL: '" + key + "' should have been included but was missing!");
                allIncludedOk = false;
            }
        }

        // 2. Encode
        String base64 = ObjectToBase64Util.toBase64(claim);
        System.out.println("\n=== Base64 output ===");
        System.out.println(base64);

        // 3. Decode back to JSON text and verify round-trip content
        String decodedJson = ObjectToBase64Util.decodeToJson(base64);
        System.out.println("\n=== Decoded JSON ===");
        System.out.println(decodedJson);

        boolean roundTripOk = decodedJson.contains("\"Water Damage Claim\"")
            && decodedJson.contains("\"PENDING\"")
            && decodedJson.contains("18500.75")
            && decodedJson.contains("true")
            && !decodedJson.contains("nested")   // proof the Map field never leaked in
            && !decodedJson.contains("urgent");  // proof the List field never leaked in

        System.out.println("\n=== Result ===");
        System.out.println("Excluded fields correctly excluded: " + allExcludedOk);
        System.out.println("Included fields correctly included: " + allIncludedOk);
        System.out.println("Base64 encode/decode round-trip correct: " + roundTripOk);
        System.out.println("Field count in output (expected 9): " + filtered.size());

        if (allExcludedOk && allIncludedOk && roundTripOk && filtered.size() == 9) {
            System.out.println("\nALL TESTS PASSED");
        } else {
            System.out.println("\nTESTS FAILED");
            System.exit(1);
        }
    }
}