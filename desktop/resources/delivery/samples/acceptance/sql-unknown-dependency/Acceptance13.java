package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance13 {
Statement stmt; ExternalSqlPolicy policy; @GetMapping("/external-sql") void external(String q) throws Exception { String cleaned=policy.sanitize(q); stmt.executeQuery("SELECT id FROM clients WHERE name="+cleaned); }
}
