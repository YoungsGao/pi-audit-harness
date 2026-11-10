package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance03 {
Statement stmt; @GetMapping("/sort") void sort(String order) throws Exception { String column; if("name".equals(order)) column="name"; else if("id".equals(order)) column="id"; else throw new IllegalArgumentException(); stmt.executeQuery("SELECT id FROM clients ORDER BY "+column); }
}
