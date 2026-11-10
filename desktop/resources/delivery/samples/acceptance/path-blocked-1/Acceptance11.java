package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance11 {
@GetMapping("/guide") byte[] guide(String name) throws Exception { if(!"guide".equals(name)) throw new IllegalArgumentException(); return Files.readAllBytes(Path.of("/srv/static/guide.txt")); }
}
