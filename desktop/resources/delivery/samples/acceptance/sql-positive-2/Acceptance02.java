package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance02 {
Statement stmt; @PostMapping("/find") void find(String term) throws Exception { String sql="SELECT id FROM clients WHERE name LIKE '%"+term+"%'"; stmt.executeQuery(sql); }
}
