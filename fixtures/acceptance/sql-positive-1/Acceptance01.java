package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance01 {
Statement stmt; @GetMapping("/lookup") void lookup(String q) throws Exception { stmt.executeQuery("SELECT name FROM clients WHERE id=" + q); }
}
