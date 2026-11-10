package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance10 {
@PostMapping("/open") void open(String filename) throws Exception { new FileInputStream(filename).close(); }
}
